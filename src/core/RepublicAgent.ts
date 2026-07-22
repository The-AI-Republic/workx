/**
 * Main RepublicAgent class
 * Thin orchestration wrapper over RepublicAgentEngine.
 * Handles platform-specific concerns (tab binding, config subscriptions, model hot-swap)
 * and delegates all execution to the engine's single SQ/EQ loop.
 */

import type { Op, ReviewDecision, InputItem as ProtocolInputItem } from './protocol/types';
import type { Event, EventMsg } from './protocol/events';
import type { AgentReadyState } from './models/types/Auth';
import type { AuthContext } from './auth/AuthContext';
import type { InitialHistory } from './session/state/types';
import type { SessionServices } from './session/state/SessionServices';
import type {
  EngineEvent,
  EngineOp,
  InputItem as EngineInputItem,
} from './engine/RepublicAgentEngineConfig';
import { AgentConfig } from '../config/AgentConfig';
import { Session } from './Session';
import { TurnContext } from './TurnContext';
import { EXTENSION_UNATTENDED_RESET_CAP_MS } from './models/resilience/withRetry';
import { ApprovalManager } from './ApprovalManager';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ModelClientFactory } from './models/ModelClientFactory';
import { RepublicAgentEngine } from './engine/RepublicAgentEngine';
import type { TrackedEngineSubmission } from './engine/RepublicAgentEngine';
import { AutoCompactHook } from './compact/autoCompactHook';
import { type IUserNotifier, NoOpNotifier } from './IUserNotifier';
import { v4 as uuidv4 } from 'uuid';
import {
  loadUserInstructions,
  createPromptLoader,
  type AgentPromptLoader,
  type PromptRuntimeContext,
} from './PromptLoader';
import type { AgentMode } from '../prompts/PromptComposer';
import { MODES } from '../prompts/PromptComposer';
import { HookRegistry } from './hooks/HookRegistry';
import { HookExecutor } from './hooks/HookExecutor';
import { HookDispatcher } from './hooks/HookDispatcher';
import { ConfigHookLoader } from './hooks/loaders/ConfigHookLoader';
import type { HookInput } from './hooks/types';
import type { IPlatformAdapter } from './platform/IPlatformAdapter';
import { processUserInput } from './input/processUserInput';
import type { FunnelContext, InputOrigin } from './input/types';
import type { AgentDisposeReason, ManagerAction } from './assembly/AgentAssembler';
import {
  finishResponseLatencyTrace,
  markResponseLatency,
  setResponseLatencySubmissionId,
} from './diagnostics/responseLatency';
import { captureOriginalDataTurnSnapshot } from './data-sources';

/** Marks an Op object that has already passed through the input funnel.
 *  Defensive only: it guards re-submission of the *same op object*, not a
 *  freshly re-derived op (connector/scheduler/chaining build new ops, which
 *  are correctly re-funnelled). See design §7.6. */
const FUNNELLED = Symbol('track13.funnelled');

/** Track 13 — claudy parity (processUserInput.ts:272-279): cap hook output
 *  surfaced to the user / model. */
const MAX_HOOK_OUTPUT_LENGTH = 10000;
function applyHookTruncation(content: string): string {
  if (content.length > MAX_HOOK_OUTPUT_LENGTH) {
    return `${content.substring(0, MAX_HOOK_OUTPUT_LENGTH)}… [output truncated - exceeded ${MAX_HOOK_OUTPUT_LENGTH} characters]`;
  }
  return content;
}

/**
 * Event dispatcher function type
 * Used to route events to UI channels without hardcoding chrome.runtime
 */
export type EventDispatcher = (event: Event) => void | Promise<void>;
export type RebuildReason = 'auth' | 'model' | 'provider' | 'tools' | 'prompt' | 'full';

export interface RepublicAgentOptions {
  promptLoader?: AgentPromptLoader;
  sessionStartReason?: 'create' | 'hydrate';
  authContext?: AuthContext;
  onMissingKey?: (providerId: string) => void;
}

export class RepublicAgent {
  private _agentId: string;
  private nextId: number = 1;
  private session: Session;
  private config: AgentConfig;
  private approvalManager: ApprovalManager;
  private toolRegistry: ToolRegistry;
  private modelClientFactory: ModelClientFactory;
  private platformAdapter: IPlatformAdapter;
  private userNotifier: IUserNotifier;
  private eventDispatcher: EventDispatcher | null = null;
  private engine: RepublicAgentEngine | null = null;
  private readonly pendingRebuildReasons = new Set<RebuildReason>();
  // Non-null signals a deferred per-session mode switch, applied on the next
  // idle edge. Set when SetSessionMode arrives while a task is running.
  private pendingModeSwitch: AgentMode | null = null;
  private pendingModeApply: Promise<void> | null = null;
  private modeWorkUnsubscribe: () => void = () => undefined;
  // Hook system
  private hookRegistry: HookRegistry;
  private hookExecutor: HookExecutor;
  private hookDispatcher: HookDispatcher;
  private autoCompactHook: AutoCompactHook | null = null;
  private cleanupPromise: Promise<void> | null = null;
  private readonly promptLoader: AgentPromptLoader;
  private memoryPromptUnregister: (() => void) | null = null;
  private readonly sessionStartReason: 'create' | 'hydrate';

  constructor(
    config: AgentConfig,
    platformAdapter: IPlatformAdapter,
    initialHistory?: InitialHistory,
    agentId?: string,
    userNotifier?: IUserNotifier,
    services?: SessionServices,
    options: RepublicAgentOptions = {},
  ) {
    // Generate or use provided agentId for multi-instance tracking (Feature 015)
    this._agentId = agentId ?? `agent_${uuidv4()}`;

    // Config must be provided (use await AgentConfig.getInstance() if needed)
    this.config = config;
    this.platformAdapter = platformAdapter;

    // Initialize components with config
    this.modelClientFactory = new ModelClientFactory({
      authContext: options.authContext,
      onMissingKey: options.onMissingKey ?? ((providerId) => {
        const providerName = this.config.getProvider(providerId)?.name ?? providerId;
        const warningMsg = `No API key configured for provider: ${providerName}. Please configure API key in Settings.`;
        console.warn('[RepublicAgent]', warningMsg);
        this.emitEvent({
          type: 'BackgroundEvent',
          data: { message: warningMsg, level: 'warning' },
        });
      }),
    });
    this.toolRegistry = new ToolRegistry();
    this.approvalManager = new ApprovalManager(this.config, (event) => this.emitEvent(event.msg));
    this.userNotifier = userNotifier ?? new NoOpNotifier();
    this.sessionStartReason = options.sessionStartReason ?? 'create';
    const promptAgentType = this.platformAdapter.platformId === 'extension'
      ? 'workx' as const
      : this.platformAdapter.platformId === 'server'
        ? 'workx-server' as const
        : 'workx-desktop' as const;
    this.promptLoader = options.promptLoader ?? createPromptLoader({
      agentType: promptAgentType,
      staticPlatformContext: {
        browserConnection: this.platformAdapter.platformId === 'extension' ? 'extension' : 'bridge',
        personaName: this.config.getConfig().preferences?.personaName,
      },
      dynamicContext: (ctx) => ({
        planReviewActive: ctx.toolRegistry?.isPlanReviewActive?.()
          ?? this.toolRegistry.isPlanReviewActive?.()
          ?? false,
      }),
    });

    // Initialize session with config and toolRegistry
    this.session = new Session(this.config, true, services, this.toolRegistry, initialHistory);
    this.session.setPromptLoader(this.promptLoader);
    // Wire up session event emitter to RepublicAgent's event queue
    this.session.setEventEmitter(async (event: Event) => this.emitEvent(event.msg));
    // Wire the efficient-model client (cheap model for app-logistics tasks:
    // titles, suggestions) — resolution policy lives in the factory.
    // Optional call: mocked/legacy Session doubles may not implement it.
    this.session.setEfficientClientProvider?.(() => this.modelClientFactory.createEfficientClient());
    this.modeWorkUnsubscribe = this.session.subscribeBackgroundWorkChanged?.((busy) => {
      if (!busy) void this.applyPendingModeAtIdle();
    }) ?? (() => undefined);

    // Initialize hook system
    this.hookRegistry = new HookRegistry();
    this.hookExecutor = new HookExecutor();
    this.hookDispatcher = new HookDispatcher(this.hookRegistry, this.hookExecutor);
    this.hookDispatcher.setEventEmitter((msg) => this.emitEvent(msg));
    this.session.setHookDispatcher(this.hookDispatcher);

    // Setup event processing for notifications
    this.setupNotificationHandlers();

  }

  /**
   * Get the unique agent ID for this instance
   * Used for multi-agent instance tracking (Feature 015)
   */
  get agentId(): string {
    return this._agentId;
  }

  /**
   * Initialize the agent (ensures config is loaded)
   * Creates model client during initialization with nullable API key
   */
  async initialize(): Promise<void> {
    // Wait for session background initialization (memory service, rollout, etc.)
    await this.session.initialize();

    // Initialize model client factory with config
    await this.modelClientFactory.initialize(this.config);

    // Validate the API key for the selected model's provider.
    const configData = this.config.getConfig();
    const selectedModelKey = configData.selectedModelKey;
    const modelData = this.config.getModelByKey(selectedModelKey);

    if (!modelData) {
      const errorMsg = `Selected model ${selectedModelKey} not found`;
      console.error('[RepublicAgent]', errorMsg);
      throw new Error(errorMsg);
    }

    // Register platform tools via adapter (replaces __BUILD_MODE__-based detection)
    await this.platformAdapter.registerPlatformTools(
      this.toolRegistry,
      this.config.getToolsConfig(),
      {
        supportsImage: modelData.model.supportsImage ?? false,
      },
      this.promptLoader,
    );

    // Wire tool context for adapters that need lazy browser connection (desktop MCP)
    if (this.platformAdapter.setToolContext) {
      this.platformAdapter.setToolContext(
        this.toolRegistry,
        (msg: { type: string; data: Record<string, unknown> }) => this.emitEvent(msg as EventMsg)
      );
    }
    this.toolRegistry.setPageContextProvider?.(
      this.platformAdapter.getCurrentPageContext
        ? () => this.platformAdapter.getCurrentPageContext!()
        : undefined
    );

    // Register/unregister memory tools based on current memory service state
    await this.syncMemoryTools();

    // Create model client and turn context during initialization
    // API key can be null - validation happens when making API requests
    // Use createClientForCurrentModel() to properly use selectedModelKey from config
    const modelClient = await this.modelClientFactory.createClientForCurrentModel();

    // Create initial TurnContext with the model client.
    // Track 12: headless deployments (WorkX Server) default to unattended
    // so scheduled/connector sessions wait out rate limits instead of
    // hard-failing with no human to retry.
    const taskContext = new TurnContext(modelClient, {
      sessionId: this.session.sessionId,
      agentMode: this.session.getAgentMode(),
      unattended: this.platformAdapter.platformId === 'server',
      unattendedResetCapMs:
        this.platformAdapter.platformId === 'extension'
          ? EXTENSION_UNATTENDED_RESET_CAP_MS
          : undefined,
    });

    // Load and set instructions
    const userInstructions = await loadUserInstructions();
    taskContext.setUserInstructions(userInstructions);
    const baseInstructions = await this.promptLoader.load(
      this.session.getAgentMode(),
      this.getPromptRuntimeContext(taskContext)
    );
    taskContext.setBaseInstructions(baseInstructions);

    // Set the turn context on the session
    this.session.setTurnContext(taskContext);

    // Load hooks once. Platform registry owns live config propagation.
    ConfigHookLoader.load(this.config, this.hookRegistry);

    // Fire SessionStart hooks (non-blocking)
    this.hookDispatcher.fire('SessionStart', {
      hook_event_name: 'SessionStart',
      session_id: this.session.sessionId,
      session_start_source: 'startup',
      session_start_reason: this.sessionStartReason,
    }).catch((err) => {
      console.warn('[RepublicAgent] SessionStart hook failed:', err);
    });

    // Create and initialize the engine with the shared session
    this.engine = new RepublicAgentEngine({
      agentConfig: this.config,
      modelClientFactory: this.modelClientFactory,
      toolRegistry: this.toolRegistry,
      systemPrompt: baseInstructions,
      userInstructions,
      session: this.session,
      ownsSession: false,
      approvalGate: this.toolRegistry.getApprovalGate() ?? undefined,
      approvalManager: this.approvalManager,
    });
    await this.engine.initialize();

    // Bridge engine events to the RepublicAgent event system
    this.wireEngineEvents();

    this.syncAutoCompactHook();

    // Track 05b: attach session-summary hook if enabled in preferences.
    // Errors are swallowed — feature is opt-in and non-critical.
    await this.syncSessionSummaryHook().catch((err) =>
      console.warn(
        '[RepublicAgent] syncSessionSummaryHook failed:',
        err instanceof Error ? err.message : String(err)
      )
    );

    // initialization complete
  }

  private async applyCurrentModelClient(selectedModelKey: string): Promise<void> {
    const modelClient = await this.modelClientFactory.createClientForCurrentModel();
    const turnCtx = this.session.getTurnContext();
    turnCtx.setModelClient(modelClient);
    turnCtx.setSelectedModelKey(selectedModelKey);
  }

  /**
   * Handle a per-session agent persona mode switch.
   *
   * Preserves conversation history. If a task is running, the switch is
   * deferred until the current task reaches its idle boundary. The UI
   * commits the tab's mode on ModeChanged{applied:true} and shows a pending
   * state on {applied:false}.
   */
  private async handleSetSessionMode(op: Extract<Op, { type: 'SetSessionMode' }>): Promise<void> {
    const requested = op.mode;
    const sessionId = this.session.getId();

    if (!this.supportsSessionMode(requested)) {
      console.warn(`[RepublicAgent] Ignoring unknown session mode: ${requested}`);
      return;
    }

    if (this.session.getAgentMode() === requested && this.pendingModeSwitch === null) {
      this.emitEvent({
        type: 'ModeChanged',
        data: { sessionId, mode: requested, applied: true },
      });
      return;
    }

    if (this.hasLiveBackgroundWork()) {
      this.pendingModeSwitch = requested;
      this.emitEvent({
        type: 'ModeChanged',
        data: { sessionId, mode: requested, applied: false },
      });
      this.emitEvent({
        type: 'BackgroundEvent',
        data: {
          message: `Mode switch to "${MODES[requested].label}" will take effect after the current task completes.`,
          level: 'info',
        },
      });
      return;
    }

    await this.applySessionMode(requested);
    this.emitEvent({ type: 'ModeChanged', data: { sessionId, mode: requested, applied: true } });
    this.emitEvent({
      type: 'BackgroundEvent',
      data: {
        message: `Switched to ${MODES[requested].label} mode.`,
        level: 'info',
      },
    });
  }

  /**
   * Apply a mode to the live session + turn context and recompose the system
   * prompt. Does not emit ModeChanged — callers decide the applied flag.
   */
  supportsSessionMode(mode: AgentMode): boolean {
    return Boolean(MODES[mode]) && this.promptLoader.supportsMode(mode);
  }

  async applySessionMode(mode: AgentMode): Promise<void> {
    if (!this.supportsSessionMode(mode)) {
      throw new Error(`Unsupported session mode: ${mode}`);
    }
    const turnCtx = this.session.getTurnContext();
    // Compose first. No durable or live state is changed unless every
    // fallible preparation step succeeds.
    const baseInstructions = await this.promptLoader.load(
      mode,
      this.getPromptRuntimeContext(turnCtx, mode),
    );
    this.session.setAgentMode(mode);
    turnCtx.setAgentMode(mode);
    turnCtx.setBaseInstructions(baseInstructions);
    this.pendingModeSwitch = null;
  }

  private applyPendingModeAtIdle(): Promise<void> {
    if (this.pendingModeApply) return this.pendingModeApply;
    const mode = this.pendingModeSwitch;
    if (!mode || this.hasLiveBackgroundWork()) return Promise.resolve();
    const sessionId = this.session.getId();
    const applying = this.applySessionMode(mode)
      .then(() => {
        this.emitEvent({ type: 'ModeChanged', data: { sessionId, mode, applied: true } });
        this.emitEvent({
          type: 'BackgroundEvent',
          data: { message: `Switched to ${MODES[mode].label} mode.`, level: 'info' },
        });
      })
      .catch((error) => {
        console.error('[RepublicAgent] Failed to apply deferred session mode:', error);
        this.emitEvent({ type: 'ModeChanged', data: { sessionId, mode, applied: false } });
      })
      .finally(() => {
        if (this.pendingModeApply === applying) this.pendingModeApply = null;
      });
    this.pendingModeApply = applying;
    return applying;
  }

  /**
   * Sync memory tools in the ToolRegistry with the current memory service state.
   * Registers tools if memory is enabled, unregisters if disabled.
   * Safe to call repeatedly — idempotent.
   */
  private static readonly MEMORY_TOOL_NAMES = ['save_memory', 'search_memory', 'forget_memory'];
  private static readonly MEMORY_PROMPT_EXTENSION = 'memory';

  /**
   * Track 05b: idempotent setup/teardown for the session-summary hook based
   * on the current `preferences.sessionSummaryEnabled` flag.
   *
   * Construction is build-mode-aware: the underlying file store relies on
   * `createMemoryFileSystem()` which throws in the extension build. We
   * silently skip in that case so the extension doesn't error at startup.
   */
  private async syncSessionSummaryHook(): Promise<void> {
    const enabled = this.config.getConfig().preferences?.sessionSummaryEnabled ?? false;
    const existing = this.session.getSessionSummaryHook();

    if (!enabled) {
      if (existing) {
        await existing.detach();
        this.session.setSessionSummaryHook(null);
      }
      return;
    }

    if (existing) return; // Already attached
    if (!this.engine) return;

    if (typeof __BUILD_MODE__ !== 'undefined' && __BUILD_MODE__ === 'extension') {
      // Memory filesystem doesn't exist in the extension build.
      return;
    }

    try {
      const { createMemoryFileSystem } = await import('./memory/MemoryFileSystem');
      const { SessionSummaryHook } = await import('./sessionSummary/SessionSummaryHook');
      const { fs, memoryDir } = await createMemoryFileSystem();

      const hook = new SessionSummaryHook({
        sessionId: this.session.getSessionId(),
        parentEngine: this.engine,
        fs,
        memoryRoot: memoryDir,
        beginLifecycleWork: () => this.session.beginLifecycleWork('session-summary'),
        promptLoader: this.promptLoader,
      });

      // attach() takes the Session-provided registrar. Bind it so the hook
      // can register/unregister its post-turn callback symmetrically.
      await hook.attach((fn) => this.session.registerPostTurnHook(fn));
      this.session.setSessionSummaryHook(hook);
    } catch (err) {
      console.warn(
        '[SessionSummary] failed to construct hook:',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private syncAutoCompactHook(): void {
    if (!this.engine) return;
    if (this.autoCompactHook) return;

    this.autoCompactHook = new AutoCompactHook({
      session: this.session,
      getModelClient: () => this.session.getTurnContext().getModelClient(),
      submitCompact: () => {
        return this.submitTrackedCompaction({ type: 'Compact', mode: 'auto' });
      },
    });
    this.autoCompactHook.attach((fn) => this.session.registerPostTurnHook(fn));
  }

  private getPromptRuntimeContext(
    turnContext?: TurnContext,
    mode: AgentMode = this.session.getAgentMode(),
  ): PromptRuntimeContext {
    return {
      sessionId: this.session.getSessionId(),
      mode,
      toolRegistry: this.toolRegistry,
      turnContext: turnContext ?? this.session.getTurnContext(),
    };
  }

  private submitTrackedCompaction(
    op: Extract<EngineOp, { type: 'Compact' | 'ManualCompact' }>,
  ): TrackedEngineSubmission {
    if (!this.engine) throw new Error('RepublicAgent engine is not initialized');
    const lease = this.session.beginLifecycleWork?.('compaction') ?? {
      token: `compat-compaction:${crypto.randomUUID()}`,
      signal: new AbortController().signal,
      finish: () => undefined,
    };
    try {
      const submitTracked = (this.engine as RepublicAgentEngine & {
        submitTrackedOperation?: RepublicAgentEngine['submitTrackedOperation'];
      }).submitTrackedOperation;
      const candidate = submitTracked?.call(this.engine, op) as TrackedEngineSubmission | undefined;
      const tracked = candidate
        ? candidate
        : {
            submissionId: this.engine.submitOperation(op),
            settled: Promise.resolve({ outcome: 'completed' as const }),
            cancel: () => undefined,
          };
      if (this.session.trackLifecycleWork) {
        void this.session.trackLifecycleWork(lease, tracked.settled);
      } else {
        void tracked.settled.then(() => lease.finish(), () => lease.finish());
      }
      return tracked;
    } catch (error) {
      lease.finish();
      throw error;
    }
  }

  private async syncMemoryTools(): Promise<void> {
    const ms = this.session.getMemoryService();

    if (ms) {
      // Register tools if not already present
      const hasMemoryTools = this.toolRegistry.getTool('save_memory') !== null;
      if (!hasMemoryTools) {
        const { registerMemoryTools } = await import('../tools/MemoryTools');
        await registerMemoryTools(this.toolRegistry, () => this.session.getMemoryService());
      }

      // Register prompt extension for core memory injection
      this.memoryPromptUnregister?.();
      this.memoryPromptUnregister = this.promptLoader.registerExtension(RepublicAgent.MEMORY_PROMPT_EXTENSION, () => {
        const svc = this.session.getMemoryService();
        return svc ? svc.getCachedGlobalContext() : '';
      });
    } else {
      // Unregister tools
      for (const name of RepublicAgent.MEMORY_TOOL_NAMES) {
        if (this.toolRegistry.getTool(name) !== null) {
          await this.toolRegistry.unregister(name);
        }
      }

      // Unregister prompt extension
      this.memoryPromptUnregister?.();
      this.memoryPromptUnregister = null;
    }
  }

  /** Rebuild model/prompt/memory state without replacing TurnContext policy. */
  async rebuildExecutionContext(reasons: ReadonlySet<RebuildReason>): Promise<void> {
    for (const reason of reasons) this.pendingRebuildReasons.add(reason);
    if (this.hasLiveBackgroundWork()) return;

    const applying = new Set(this.pendingRebuildReasons);
    this.pendingRebuildReasons.clear();
    const needs = (reason: RebuildReason): boolean =>
      applying.has(reason) || applying.has('full');
    const rebuildClient = needs('auth') || needs('model') || needs('provider');
    const rebuildPrompt = rebuildClient || needs('tools') || needs('prompt');

    try {
      const turnCtx = this.session.getTurnContext();
      const candidateClient = rebuildClient
        ? await (async () => {
            this.modelClientFactory.clearCache();
            return this.modelClientFactory.createClientForCurrentModel();
          })()
        : null;
      const candidateInstructions = needs('prompt')
        ? await loadUserInstructions()
        : turnCtx.getUserInstructions?.();

      if (rebuildClient || needs('prompt')) {
        await this.session.refreshMemoryService(this.config);
      }
      await this.syncMemoryTools();
      await this.syncSessionSummaryHook();

      const candidatePrompt = rebuildPrompt
        ? await this.promptLoader.load(
            this.session.getAgentMode(),
            this.getPromptRuntimeContext(turnCtx),
          )
        : turnCtx.getBaseInstructions?.();

      if (candidateClient) {
        turnCtx.setModelClient(candidateClient);
        turnCtx.setSelectedModelKey(this.config.getConfig().selectedModelKey);
      }
      if (candidateInstructions !== undefined) turnCtx.setUserInstructions(candidateInstructions);
      if (candidatePrompt !== undefined) turnCtx.setBaseInstructions(candidatePrompt);
    } catch (error) {
      for (const reason of applying) this.pendingRebuildReasons.add(reason);
      throw error;
    }
  }

  async applyManagerActions(actions: ReadonlySet<ManagerAction>): Promise<void> {
    if (actions.has('reload-hooks')) {
      ConfigHookLoader.load(this.config, this.hookRegistry);
    }
    if (actions.has('reload-approval')) {
      const approval = this.config.getConfig().approval;
      const gate = this.toolRegistry.getApprovalGate();
      if (approval && gate) {
        gate.setMode(approval.mode);
        gate.setTrustedDomains(approval.trustedDomains ?? []);
        gate.setBlockedDomains(approval.blockedDomains ?? []);
      }
    }
  }

  private hasLiveBackgroundWork(): boolean {
    return this.session.hasLiveBackgroundWork?.()
      ?? ((this.session.getRunningTasks?.().size ?? 0) > 0);
  }

  /**
   * Submit an operation to the agent.
   * Orchestration-only ops are handled locally.
   * Execution ops are forwarded to the engine after pre-submit hooks.
   * Returns a submission ID.
   */
  async submitOperation(
    op: Op,
    // Track 13 (origin/_chainDepth: input funnel) + Track 12 (unattended:
    // retry posture) — orthogonal concerns, unioned.
    context?: {
      tabId?: number;
      origin?: InputOrigin;
      _chainDepth?: number;
      unattended?: boolean;
    }
  ): Promise<string> {
    const id = `sub_${this.nextId++}`;
    const responseLatencyId = op.type === 'UserInput' ? op.clientMessageId : undefined;

    // Track 12: a scheduler/connector driver can mark this submission
    // unattended; apply it to the live TurnContext before the turn runs
    // (TurnManager reads getUnattended() fresh each turn).
    if (context?.unattended !== undefined) {
      this.session.updateTurnContext({ unattended: context.unattended });
    }

    try {
      // Guard: engine must be initialized before forwarding execution ops
      const requireEngine = () => {
        if (!this.engine) {
          throw new Error(
            'RepublicAgent not initialized. Call initialize() before submitOperation().'
          );
        }
        return this.engine;
      };

      switch (op.type) {
        // === Orchestration-only ops (handled locally, no engine involvement) ===
        case 'GetPath':
          await this.handleGetPath();
          break;

        case 'OverrideTurnContext':
          await this.handleOverrideTurnContext(op);
          break;

        case 'GetHistoryEntryRequest':
          await this.handleGetHistoryEntryRequest(op);
          break;

        case 'SetSessionMode':
          await this.handleSetSessionMode(op);
          break;

        // === UserInput/UserTurn: run pre-submit hooks, then delegate to engine ===
        // Return the engine's submission ID so callers can correlate with lifecycle events
        case 'UserInput':
        case 'UserTurn': {
          const dataTurnSnapshot = captureOriginalDataTurnSnapshot(op, context);
          // ── Track 13: input funnel runs ONCE, before hooks, so the
          //    UserPromptSubmit hook sees expanded/enriched input. One
          //    placement covers ext, desktop, and all server input
          //    sources. See design §4.3.
          let userOp = op as Extract<Op, { type: 'UserInput' | 'UserTurn' }>;
          if (!(userOp as Record<symbol, unknown>)[FUNNELLED]) {
            // The funnel is strictly additive: any unexpected failure inside
            // it must NOT abort the turn (design risk: never abort a
            // scheduled/connector job). On error, proceed with the original
            // op unchanged.
            let processed: Awaited<ReturnType<typeof processUserInput>> | null = null;
            try {
              processed = await processUserInput(
                userOp.items,
                this.buildFunnelContext(userOp, context)
              );
            } catch (funnelErr) {
              console.error(
                '[RepublicAgent] input funnel failed; proceeding with raw input:',
                funnelErr
              );
              processed = null;
            }
            if (processed && !processed.shouldQuery) {
              // Handled by the funnel (blocked / slash / bash) — no engine turn.
              const message = processed.resultText ?? processed.systemNote;
              if (message) {
                this.emitEvent({ type: 'Error', data: { message } });
              }
              // Command chaining (claudy nextInput/submitNextInput). Bounded
              // recursion via _chainDepth so a misbehaving chain can't loop.
              if (processed.nextInput && processed.submitNextInput) {
                const depth = (context?._chainDepth ?? 0) + 1;
                if (depth <= 3) {
                  await this.submitOperation(
                    {
                      type: 'UserInput',
                      items: [{ type: 'text', text: processed.nextInput }],
                    },
                    { ...context, _chainDepth: depth }
                  );
                }
              }
              finishResponseLatencyTrace(responseLatencyId, 'submission_rejected');
              return id;
            }
            if (processed) {
              if (processed.systemNote) {
                // Non-blocking degradation notice (e.g. "@page unavailable").
                this.emitEvent({
                  type: 'AgentMessage',
                  data: { message: processed.systemNote },
                });
              }
              userOp = { ...userOp, items: processed.items };
              (userOp as Record<symbol, unknown>)[FUNNELLED] = true;
            }
          }
          markResponseLatency(responseLatencyId, 'agent_input_funnel_finished');
          op = userOp;

          const shouldContinue = await this.preSubmitHooks(op, context);
          if (!shouldContinue) {
            // UserPromptSubmit hook blocked — return local id without engine submission
            finishResponseLatencyTrace(responseLatencyId, 'submission_rejected');
            return id;
          }
          const engineSubmissionId = requireEngine().submitOperation(
            this.toEngineOp(op, dataTurnSnapshot),
          );
          if (responseLatencyId) {
            setResponseLatencySubmissionId(responseLatencyId, engineSubmissionId);
            markResponseLatency(responseLatencyId, 'engine_submission_created');
          }
          return engineSubmissionId;
        }

        // === Forward execution ops to engine ===
        case 'ExecApproval':
          requireEngine().submitOperation({
            type: 'ExecApproval',
            callId: op.id,
            decision: op.decision,
            remember: op.remember,
            alternativeText: op.alternativeText,
          });
          break;

        case 'PatchApproval':
          requireEngine().submitOperation({
            type: 'PatchApproval',
            patchId: op.id,
            decision: op.decision,
          });
          break;

        case 'Interrupt':
          await this.userNotifier.notifyWarning(
            'Task Interrupted',
            'The current task has been interrupted by user request'
          );
          requireEngine().submitOperation({
            type: 'Interrupt',
            reason: 'user_interrupt',
          });
          break;

        case 'Compact':
          this.submitTrackedCompaction({ type: 'Compact', mode: 'auto' });
          break;

        case 'ManualCompact':
          this.submitTrackedCompaction({ type: 'ManualCompact' });
          break;

        case 'AddToHistory':
          requireEngine().submitOperation({
            type: 'AddToHistory',
            text: op.text,
          });
          break;

        case 'Shutdown':
          // Cleanly tear down the engine. dispose() is idempotent and emits
          // EngineDisposed, which is the canonical "we're done" signal. Do
          // NOT also submit a Shutdown op — that double-handles teardown and
          // races the dispose path.
          await requireEngine().dispose();
          break;

        default:
          this.emitEvent({
            type: 'AgentMessage',
            data: {
              message: `Operation type ${(op as any).type} not yet implemented`,
            },
          });
      }
    } catch (error) {
      finishResponseLatencyTrace(responseLatencyId, 'submission_failed');
      // Emit TurnAborted event on error
      this.emitEvent({
        type: 'TurnAborted',
        data: {
          reason: 'error',
          submission_id: id,
        },
      });
      this.emitEvent({
        type: 'Error',
        data: {
          message: error instanceof Error ? error.message : 'Unknown error occurred',
        },
      });
    }

    return id;
  }

  /**
   * Assemble the {@link FunnelContext} for the Track 13 input funnel.
   * `origin` defaults to `local` (trusted UI) when a caller does not supply
   * one — preserving current behavior for the webfront path. The bridge-safe
   * gate only engages for non-`local` origins (connector / remote / scheduler).
   */
  private buildFunnelContext(
    op: Extract<Op, { type: 'UserInput' | 'UserTurn' }>,
    context?: { tabId?: number; origin?: InputOrigin }
  ): FunnelContext {
    const tabId = op.type === 'UserTurn' && op.tabId !== undefined ? op.tabId : context?.tabId;
    return {
      sessionId: this.session.sessionId,
      origin: context?.origin ?? { channel: 'local' },
      platform: this.platformAdapter,
      // Track 09 store — may be undefined when persistence is disabled for
      // the platform; the funnel then leaves items unchanged. Guarded so a
      // session without the accessor cannot abort a submission.
      resultStore:
        typeof this.session.getToolResultStore === 'function'
          ? this.session.getToolResultStore()
          : undefined,
      tabId,
    };
  }

  /**
   * Pre-submit hooks: UserPromptSubmit hook + tab binding + pending model switch.
   * Run before forwarding UserInput/UserTurn to the engine.
   *
   * Returns `false` if a UserPromptSubmit hook blocked the operation, in which
   * case the caller must skip engine submission.
   */
  private async preSubmitHooks(
    op: Extract<Op, { type: 'UserInput' }> | Extract<Op, { type: 'UserTurn' }>,
    context?: { tabId?: number }
  ): Promise<boolean> {
    const responseLatencyId = op.type === 'UserInput' ? op.clientMessageId : undefined;
    const hookStartedAt = Date.now();
    // Fire UserPromptSubmit hooks before any work
    const textContent = (op.items ?? [])
      .filter((i: any) => i.type === 'text')
      .map((i: any) => i.text ?? '')
      .join('\n');

    if (textContent) {
      const hookInput: HookInput = {
        hook_event_name: 'UserPromptSubmit',
        session_id: this.session.sessionId,
        user_prompt: textContent,
      };
      const hookResult = await this.hookDispatcher.fire('UserPromptSubmit', hookInput);
      if (!hookResult.shouldContinue) {
        // claudy parity: a blocking hook erases the input; the user sees a
        // warning that embeds the original prompt (processUserInput.ts:194-209).
        const reason = hookResult.stopReason ?? 'UserPromptSubmit hook blocked this input';
        this.emitEvent({
          type: 'Error',
          data: {
            message: applyHookTruncation(`${reason}\n\nOriginal prompt: ${textContent}`),
          },
        });
        return false;
      }

      // claudy parity: surface hook system messages (truncated, informational).
      for (const sysMsg of hookResult.systemMessages ?? []) {
        if (sysMsg && sysMsg.trim()) {
          this.emitEvent({
            type: 'AgentMessage',
            data: { message: applyHookTruncation(sysMsg) },
          });
        }
      }

      // claudy parity: fold additionalContext in as a model-visible item
      // (createAttachmentMessage 'hook_additional_context'). Rides alongside
      // the prompt — the user's text item is untouched.
      const extra = (hookResult.additionalContext ?? []).filter((c) => c && c.trim());
      if (extra.length > 0) {
        const joined = extra.map(applyHookTruncation).join('\n');
        op.items = [
          ...op.items,
          {
            type: 'text',
            text: `<hook-additional-context>\n${joined}\n</hook-additional-context>`,
          },
        ];
      }
    }
    markResponseLatency(responseLatencyId, 'user_prompt_hooks_finished', {
      duration_ms: Date.now() - hookStartedAt,
    });

    // Tab binding (platform adapter concern)
    const tabContext = op.type === 'UserTurn' && op.tabId !== undefined
      ? { tabId: op.tabId }
      : context;
    const tabBindingStartedAt = Date.now();
    await this.handleTabBinding(tabContext);
    markResponseLatency(responseLatencyId, 'tab_binding_finished', {
      duration_ms: Date.now() - tabBindingStartedAt,
    });

    const rebuildStartedAt = Date.now();
    const rebuildRequired = this.pendingRebuildReasons.size > 0;
    if (this.pendingRebuildReasons.size > 0) {
      await this.rebuildExecutionContext(new Set(this.pendingRebuildReasons));
    }
    markResponseLatency(responseLatencyId, 'execution_context_ready', {
      duration_ms: Date.now() - rebuildStartedAt,
      rebuild_required: rebuildRequired,
    });

    return true;
  }

  /**
   * Convert a protocol InputItem to an engine InputItem.
   * Protocol types: text, image (image_url), clipboard (content), context (path)
   * Engine types:   text (text), image (data, mimeType), file (path)
   */
  private static convertInputItem(item: ProtocolInputItem): EngineInputItem {
    switch (item.type) {
      case 'text':
        return { type: 'text', text: item.text };
      case 'image': {
        // Protocol uses image_url (data URI), engine expects data + mimeType
        const dataUri = item.image_url;
        const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          return { type: 'image', data: match[2], mimeType: match[1] };
        }
        // Fallback: pass the whole URI as data
        return { type: 'image', data: dataUri, mimeType: 'image/png' };
      }
      case 'clipboard':
        // Clipboard content is text-like; convert to text item
        return { type: 'text', text: item.content ?? '' };
      case 'context':
        // Context with a path maps to the engine's file type
        return { type: 'file', path: item.path };
      default:
        // Exhaustiveness guard — treat unknown types as text
        return { type: 'text', text: '' };
    }
  }

  /**
   * Convert a RepublicAgent Op to an EngineOp for forwarding to the engine.
   */
  private toEngineOp(
    op: Extract<Op, { type: 'UserInput' }> | Extract<Op, { type: 'UserTurn' }>,
    dataTurnSnapshot: import('./data-sources').DataTurnSnapshot
  ): EngineOp {
    const items = op.items.map(RepublicAgent.convertInputItem);

    if (op.type === 'UserInput') {
      return {
        type: 'UserInput',
        items,
        context: { metadata: { dataTurnSnapshot } },
        clientMessageId: op.clientMessageId,
        inputDigest: op.inputDigest,
      };
    }
    // UserTurn with context overrides — only include defined values
    // to avoid overwriting existing context with undefined
    const overrides: Record<string, unknown> = {};
    if (op.approval_policy !== undefined) overrides.approval_policy = op.approval_policy;
    if (op.sandbox_policy !== undefined) overrides.sandbox_policy = op.sandbox_policy;
    if (op.model !== undefined) overrides.model = op.model;
    if (op.effort !== undefined) overrides.effort = op.effort;
    if (op.summary !== undefined) overrides.summary = op.summary;

    return {
      type: 'UserTurn',
      items,
      context: { metadata: { dataTurnSnapshot } },
      contextOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    };
  }

  /**
   * Handle tab binding/creation/switching based on session state and context
   * @param submissionContext - Context containing optional tabId
   */
  private async handleTabBinding(submissionContext?: { tabId?: number }): Promise<void> {
    const resources = this.platformAdapter.browserResources;
    if (!resources) return;
    const currentTabId = (await resources.current())?.tabId ?? -1;
    const newTabId = submissionContext?.tabId ?? -1;

    // ================================================================
    // CASE 1: newTabId is -1 → Create a new tab
    // ================================================================
    if (newTabId === -1) {
      try {
        // Lazy browser setup (e.g., desktop MCP connection)
        await this.platformAdapter.ensureBrowserReady?.();

        const created = await resources.create({ url: 'about:blank', active: false });
        const createdTabId = created.tabId;

        this.emitEvent({
          type: 'StateUpdate',
          data: { sessionId: this.session.getId(), tabId: createdTabId },
        });
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : 'Unknown error during tab creation';

        this.emitEvent({
          type: 'Error',
          data: { message: `Failed to create browser tab: ${errorMsg}` },
        });

        throw error;
      }
    }
    // ================================================================
    // CASE 2: newTabId === currentTabId → Check health, don't rebind
    // ================================================================
    else if (newTabId === currentTabId) {
      await resources.getOwned(currentTabId);
    }
    // ================================================================
    // CASE 3: newTabId !== currentTabId → Switch to new tab
    // ================================================================
    else {
      try {
        await resources.claimExisting(newTabId, 'user');
        await resources.setCurrent(newTabId);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error during tab switching';
        this.emitEvent({
          type: 'Error',
          data: { message: `Failed to switch to tab ${newTabId}: ${errorMsg}` },
        });
        throw error;
      }
    }

    this.emitEvent({
      type: 'BackgroundEvent',
      data: {
        message: `Tab binding updated: session ${this.session.getId()} now bound to tab ${(await resources.current())?.tabId ?? -1}`,
        level: 'info',
      },
    });
  }

  /**
   * Cancel a running task by submission id.
   *
   * Track 04: narrow to per-task abort so background sub-agent tasks
   * survive user interrupts that target a different task. Falls through
   * to abortAllTasks only if the task is the foreground task and Session's
   * narrow path isn't applicable (e.g., older code paths).
   */
  async cancelTask(submissionId: string): Promise<void> {
    if (this.session.hasRunningTask(submissionId)) {
      await this.session.abortTask(submissionId, 'UserInterrupt');
    }
  }

  /**
   * Handle override turn context
   */
  private async handleOverrideTurnContext(
    op: Extract<Op, { type: 'OverrideTurnContext' }>
  ): Promise<void> {
    const updates: any = {};

    if (op.tabId !== undefined) updates.tabId = op.tabId;
    if (op.approval_policy !== undefined) updates.approval_policy = op.approval_policy;
    if (op.sandbox_policy !== undefined) updates.sandbox_policy = op.sandbox_policy;
    if (op.model !== undefined) updates.model = op.model;
    if (op.effort !== undefined) updates.effort = op.effort;
    if (op.summary !== undefined) updates.summary = op.summary;

    this.session.updateTurnContext(updates);
  }

  /**
   * Handle get path request
   */
  private async handleGetPath(): Promise<void> {
    const conversationHistory = this.session.getConversationHistory();
    this.emitEvent({
      type: 'ConversationPath',
      data: {
        path: this.session.sessionId,
        messages_count: conversationHistory.items.length,
      },
    });
  }

  /**
   * Handle get history entry request
   */
  private async handleGetHistoryEntryRequest(
    op: Extract<Op, { type: 'GetHistoryEntryRequest' }>
  ): Promise<void> {
    try {
      const entry = this.session.getHistoryEntry(op.offset);

      if (entry) {
        this.emitEvent({
          type: 'BackgroundEvent',
          data: {
            message: `History entry ${op.offset}: ${JSON.stringify(entry).substring(0, 100)}...`,
            level: 'info',
          },
        });
      } else {
        this.emitEvent({
          type: 'Error',
          data: {
            message: `History entry ${op.offset} not found`,
          },
        });
      }
    } catch (error) {
      this.emitEvent({
        type: 'Error',
        data: {
          message: `Failed to get history entry: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      });
      throw error;
    }
  }

  /**
   * Wire engine events to the RepublicAgent's eventDispatcher.
   * The engine emits EngineEvents; we convert and dispatch them to the UI.
   */
  /**
   * Engine-only event types that don't originate from session's event emitter.
   * These need to be forwarded explicitly to the RepublicAgent event system.
   */
  private static readonly ENGINE_ONLY_EVENTS = new Set([
    'ShutdownComplete',
    'EngineDisposed',
    'TaskStarted',
    'CompactionCompleted',
    'TurnAborted',
    'HistoryCleared',
    'BackgroundEvent',
    'Error',
    'SubAgentStart',
    'SubAgentComplete',
    'SubAgentError',
  ]);

  private wireEngineEvents(): void {
    if (!this.engine) return;
    this.engine.onEvent((engineEvent: EngineEvent) => {
      if (engineEvent.msg.type === 'CompactionCompleted') {
        this.autoCompactHook?.handleCompactionCompleted(engineEvent.msg.data?.success === true);
      }
      // Session-originated events are already dispatched via the session's emitter
      // (wired in the constructor). Only forward engine-only events that don't
      // originate from session to avoid duplicate dispatching.
      if (RepublicAgent.ENGINE_ONLY_EVENTS.has(engineEvent.msg.type)) {
        this.emitEvent(engineEvent.msg as EventMsg);
      }
    });
  }

  /**
   * Set the event dispatcher
   */
  setEventDispatcher(dispatcher: EventDispatcher): void {
    this.eventDispatcher = dispatcher;
  }

  /** Emit an event through the single manager-owned dispatcher path. */
  private emitEvent(msg: EventMsg): void {
    const event: Event = {
      id: `evt_${this.nextId++}`,
      msg,
    };

    // Process event for user notifications
    this.userNotifier.processEvent(event);

    // Dispatch event through the channel system
    if (this.eventDispatcher) {
      try {
        this.eventDispatcher(event);
      } catch (error) {
        console.error('[RepublicAgent] Event dispatcher error:', error);
      }
    } else {
      console.warn('[RepublicAgent] No event dispatcher set - event not delivered to UI');
    }
  }

  /**
   * Get the current session
   */
  getSession(): Session {
    return this.session;
  }

  /**
   * Get the model client factory
   */
  getModelClientFactory(): ModelClientFactory {
    return this.modelClientFactory;
  }

  getPromptLoader(): AgentPromptLoader {
    return this.promptLoader;
  }

  /**
   * Get the tool registry
   */
  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  /**
   * Get the approval manager
   */
  getApprovalManager(): ApprovalManager {
    return this.approvalManager;
  }

  /**
   * Get the hook dispatcher.
   *
   * Exposed so platform bootstraps (extension/desktop/server) can wire the
   * dispatcher into the ApprovalGate they construct, which is required for
   * PermissionRequest and PermissionDenied hooks to fire.
   */
  getHookDispatcher(): HookDispatcher {
    return this.hookDispatcher;
  }

  /**
   * Get the hook registry.
   *
   * Exposed so SkillExecutor (Track 03) can register skill-scoped hooks
   * via SessionHookStore for the duration of a single skill invocation.
   */
  getHookRegistry(): HookRegistry {
    return this.hookRegistry;
  }

  /**
   * Get the platform adapter
   */
  getPlatformAdapter(): IPlatformAdapter {
    return this.platformAdapter;
  }

  /**
   * Get the engine instance
   */
  getEngine(): RepublicAgentEngine | null {
    return this.engine;
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    return this.dispose('manual');
  }

  async dispose(reason: AgentDisposeReason): Promise<void> {
    if (this.cleanupPromise) {
      return this.cleanupPromise;
    }
    this.cleanupPromise = this.cleanupOnce(reason);
    return this.cleanupPromise;
  }

  private async cleanupOnce(reason: AgentDisposeReason): Promise<void> {
    this.modeWorkUnsubscribe();
    this.modeWorkUnsubscribe = () => undefined;
    // Fire SessionEnd hooks with short timeout (1.5s) before tearing things down.
    // Failures here must not block shutdown.
    try {
      await this.hookDispatcher.fire(
        'SessionEnd',
        {
          hook_event_name: 'SessionEnd',
          session_id: this.session.sessionId,
          session_end_reason: reason,
        },
        { timeoutOverride: 1.5 }
      );
    } catch (err) {
      console.warn('[RepublicAgent] SessionEnd hook failed during cleanup:', err);
    }
    this.hookRegistry.unregisterBySource('config');
    this.autoCompactHook?.detach();
    this.autoCompactHook = null;

    if (this.engine) {
      await this.engine.dispose();
    }
    const abortReason = reason === 'tab-closed'
      ? 'TabClosed'
      : reason === 'error' || reason === 'assembly-failed'
        ? 'Error'
        : reason === 'shutdown'
          ? 'Shutdown'
          : 'UserInterrupt';
    await this.session.dispose({
      lifecycleReason: reason,
      abortReason,
      abortTasks: reason !== 'suspend',
      recordCloseEvent: reason === 'delete',
      flushRollout: true,
      cleanupToolResults: reason !== 'suspend',
    });
    this.memoryPromptUnregister?.();
    this.memoryPromptUnregister = null;
    this.promptLoader.dispose();
    await this.toolRegistry.cleanup();
    this.toolRegistry.clear();
    await this.userNotifier.clearAll();
    await this.platformAdapter.dispose();
  }

  /**
   * Setup notification handlers
   */
  private setupNotificationHandlers(): void {
    this.userNotifier.onNotification((notification) => {
      this.emitEvent({
        type: 'Notification',
        data: {
          id: notification.id,
          type: notification.type,
          title: notification.title,
          message: notification.message,
          timestamp: notification.timestamp,
        },
      });
    });
  }

  /**
   * Handle approval decision
   */
  private async handleApprovalDecision(
    approvalId: string,
    decision: 'approve' | 'reject'
  ): Promise<void> {
    const pendingApproval = this.approvalManager.getApproval(approvalId);
    if (!pendingApproval) return;

    const approval = pendingApproval.request;

    const reviewDecision: ReviewDecision = decision === 'approve' ? 'approve' : 'reject';

    const op: Op =
      approval.type === 'command'
        ? {
            type: 'ExecApproval',
            id: approvalId,
            decision: reviewDecision,
          }
        : {
            type: 'PatchApproval',
            id: approvalId,
            decision: reviewDecision,
          };

    await this.submitOperation(op);
  }

  /**
   * Get user notifier
   */
  getUserNotifier(): IUserNotifier {
    return this.userNotifier;
  }

  /**
   * Check if agent is ready to accept commands
   */
  async isReady(): Promise<AgentReadyState> {
    try {
      const configData = this.config.getConfig();
      const selectedModelKey = configData.selectedModelKey;
      const modelData = this.config.getModelByKey(selectedModelKey);

      if (!modelData) {
        return {
          ready: false,
          message: `Selected model ${selectedModelKey} not found`,
          authMode: 'none',
        };
      }

      const providerId = modelData.provider.id;

      const isCustomProvider = Boolean(this.config.getProvider(providerId)?.isCustom);
      const gatewayRouting =
        !isCustomProvider &&
        (await this.modelClientFactory.isGatewayRoutingAvailable(providerId));
      if ((!isCustomProvider && this.modelClientFactory.isBackendRouting()) || gatewayRouting) {
        return {
          ready: true,
          provider: modelData.provider.name,
          model: modelData.model.name,
          authMode: 'api_key',
        };
      }

      const apiKey = await this.config.getProviderApiKey(providerId);

      if (!apiKey || !apiKey.trim()) {
        return {
          ready: false,
          message: `No API key configured for ${modelData.provider.name}`,
          provider: modelData.provider.name,
          model: modelData.model.name,
          authMode: 'api_key',
        };
      }

      return {
        ready: true,
        provider: modelData.provider.name,
        model: modelData.model.name,
        authMode: 'api_key',
      };
    } catch (error) {
      return {
        ready: false,
        message: error instanceof Error ? error.message : 'Unknown error checking agent status',
        authMode: 'none',
      };
    }
  }

  /**
   * Handle interruption
   */
  async interrupt(): Promise<void> {
    this.session.requestInterrupt();

    await this.userNotifier.notifyInfo(
      'Interruption Requested',
      'The current task will be interrupted'
    );

    await this.submitOperation({ type: 'Interrupt' });
  }

  /**
   * Show progress notification
   */
  async showProgress(
    title: string,
    message: string,
    current: number,
    total: number
  ): Promise<string> {
    return this.userNotifier.notifyProgress(title, message, current, total);
  }

  /**
   * Update progress notification
   */
  async updateProgress(notificationId: string, current: number, total: number): Promise<void> {
    await this.userNotifier.updateProgress(notificationId, current, total);
  }
}
